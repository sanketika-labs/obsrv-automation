#!/bin/bash

# Script to create a shared IAM role for all Obsrv service accounts
# This role can be used by all services instead of creating individual roles

set -e

# Configuration
ROLE_NAME="${1:-obsrv-shared-sa-role}"
CLUSTER_NAME="${2}"
REGION="${3:-ap-south-1}"

if [ -z "$CLUSTER_NAME" ]; then
    echo "Usage: $0 <role-name> <cluster-name> [region]"
    echo "Example: $0 obsrv-shared-sa-role obsrv-sandbox-eks ap-south-1"
    exit 1
fi

echo "Creating shared IAM role: $ROLE_NAME"
echo "Cluster: $CLUSTER_NAME"
echo "Region: $REGION"
echo ""

# Pre-flight checks
echo "Running pre-flight checks..."

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo "Error: AWS CLI is not installed or not in PATH"
    echo "Please install AWS CLI: https://aws.amazon.com/cli/"
    exit 1
fi

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "Error: jq is not installed"
    echo "Please install jq: sudo apt-get install jq"
    exit 1
fi

# Check AWS credentials
echo "Checking AWS credentials..."
if ! aws sts get-caller-identity &> /dev/null; then
    echo "Error: AWS credentials are not configured or invalid"
    echo "Please configure AWS credentials using:"
    echo "  export AWS_ACCESS_KEY_ID=your-key"
    echo "  export AWS_SECRET_ACCESS_KEY=your-secret"
    echo "  export AWS_DEFAULT_REGION=your-region"
    exit 1
fi
echo "✓ AWS credentials valid"
echo ""

# Get the OIDC provider URL for the EKS cluster
echo "Fetching OIDC provider for cluster $CLUSTER_NAME..."
OIDC_PROVIDER=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query "cluster.identity.oidc.issuer" --output text | sed 's|https://||')

if [ -z "$OIDC_PROVIDER" ]; then
    echo "Error: Could not retrieve OIDC provider for cluster $CLUSTER_NAME"
    exit 1
fi

echo "OIDC Provider: $OIDC_PROVIDER"

# Get AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "AWS Account ID: $ACCOUNT_ID"

# Define all service accounts that need access
# Format: namespace:service-account-name
SERVICE_ACCOUNTS=(
    "secor:secor-sa"
    "dataset-api:dataset-api-sa"
    "config-api:config-api-sa"
    "druid-raw:druid-raw-sa"
    "flink:flink-sa"
    "postgresql:postgresql-backup-sa"
    "s3-exporter:s3-exporter-sa"
    "spark:spark-sa"
    "velero:velero-backup-sa"
)

# Build the service account subjects array
echo "Building Trust Policy..."
SA_SUBJECTS="["
for i in "${!SERVICE_ACCOUNTS[@]}"; do
    SA="${SERVICE_ACCOUNTS[$i]}"
    NAMESPACE="${SA%%:*}"
    SA_NAME="${SA##*:}"
    
    if [ $i -eq 0 ]; then
        SA_SUBJECTS="${SA_SUBJECTS}\"system:serviceaccount:${NAMESPACE}:${SA_NAME}\""
    else
        SA_SUBJECTS="${SA_SUBJECTS}, \"system:serviceaccount:${NAMESPACE}:${SA_NAME}\""
    fi
done
SA_SUBJECTS="${SA_SUBJECTS}]"

# Create Trust Policy JSON
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com",
          "${OIDC_PROVIDER}:sub": ${SA_SUBJECTS}
        }
      }
    }
  ]
}
EOF
)

echo "Trust Policy:"
echo "$TRUST_POLICY" | jq .

# Validate JSON before proceeding
if ! echo "$TRUST_POLICY" | jq . > /dev/null 2>&1; then
    echo "Error: Generated Trust Policy is not valid JSON!"
    exit 1
fi

# Save trust policy to a temporary file for debugging
TRUST_POLICY_FILE="/tmp/trust-policy-${ROLE_NAME}.json"
echo "$TRUST_POLICY" > "$TRUST_POLICY_FILE"
echo "Trust Policy saved to: $TRUST_POLICY_FILE"

# Create the IAM role
echo ""
echo "Creating IAM role..."
set +e  # Don't exit on error, we want to handle it
ROLE_CREATE_OUTPUT=$(aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$TRUST_POLICY_FILE" \
    --description "Shared IAM role for all Obsrv service accounts" \
    2>&1)
ROLE_CREATE_EXIT_CODE=$?
set -e

if [ $ROLE_CREATE_EXIT_CODE -eq 0 ]; then
    ROLE_ARN=$(echo "$ROLE_CREATE_OUTPUT" | jq -r '.Role.Arn')
    echo "✓ Role created successfully!"
    echo "Role ARN: $ROLE_ARN"
else
    echo "Role creation failed with exit code: $ROLE_CREATE_EXIT_CODE"
    echo "Output: $ROLE_CREATE_OUTPUT"
    
    # Check if role already exists
    if echo "$ROLE_CREATE_OUTPUT" | grep -q "EntityAlreadyExists"; then
        echo ""
        echo "Role already exists. Fetching existing role..."
        ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text 2>&1)
        
        if [[ $ROLE_ARN == arn:aws:iam::* ]]; then
            echo "✓ Role found: $ROLE_ARN"
            echo ""
            echo "Updating trust policy..."
            aws iam update-assume-role-policy \
                --role-name "$ROLE_NAME" \
                --policy-document "file://$TRUST_POLICY_FILE"
            echo "✓ Trust policy updated"
        else
            echo "Error fetching existing role: $ROLE_ARN"
            exit 1
        fi
    else
        echo "Error: Failed to create role"
        echo "Please check the error message above"
        exit 1
    fi
fi

# Attach S3 Full Access policy
echo ""
echo "Attaching AmazonS3FullAccess policy..."
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/AmazonS3FullAccess" 2>&1 || echo "Policy may already be attached"

echo ""
echo "=========================================="
echo "✓ Setup Complete!"
echo "=========================================="
echo ""
echo "Role ARN: $ROLE_ARN"
echo ""
echo "Next steps:"
echo "1. Update helmcharts/global-cloud-values-aws.yaml"
echo "2. Replace all <fill-value> with: $ROLE_ARN"
echo ""
echo "You can use this command to update the file:"
echo "sed -i 's|<fill-value>|$ROLE_ARN|g' helmcharts/global-cloud-values-aws.yaml"
echo ""
