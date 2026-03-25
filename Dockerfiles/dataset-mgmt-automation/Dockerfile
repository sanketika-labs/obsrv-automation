FROM node:25-alpine

WORKDIR /app

COPY package.json .
COPY src/ src/
COPY datasets/ datasets/

CMD ["node", "src/index.js"]
