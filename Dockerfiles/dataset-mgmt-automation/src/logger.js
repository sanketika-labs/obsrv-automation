const timestamp = () => new Date().toISOString();

const logger = {
  info: (msg, ...args) => console.log(`[${timestamp()}] [INFO]`, msg, ...args),
  warn: (msg, ...args) => console.warn(`[${timestamp()}] [WARN]`, msg, ...args),
  error: (msg, ...args) => console.error(`[${timestamp()}] [ERROR]`, msg, ...args),
};

export default logger;
