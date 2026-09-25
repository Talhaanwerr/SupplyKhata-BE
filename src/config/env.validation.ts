import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().default(4700),
  API_PREFIX: Joi.string().default('api/v1'),

  DATABASE_URL: Joi.string().required(),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  CORS_ORIGINS: Joi.string().required(),

  THROTTLE_TTL: Joi.number().default(60000),
  THROTTLE_LIMIT: Joi.number().default(100),

  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('true'),

  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly')
    .default('debug'),

  // Auth
  LOGIN_MAX_ATTEMPTS: Joi.number().default(5),
  LOGIN_LOCKOUT_MINUTES: Joi.number().default(15),

  // Email (credentials may be empty in CI / local without SMTP)
  MAIL_HOST: Joi.string().default('smtp.mailtrap.io'),
  MAIL_PORT: Joi.number().default(2525),
  MAIL_USER: Joi.string().allow('').default(''),
  MAIL_PASS: Joi.string().allow('').default(''),
  MAIL_FROM: Joi.string().default('noreply@saas.local'),
  MAIL_FROM_NAME: Joi.string().default('SaaS Platform'),
  // Optional: Brevo HTTPS API (required on Railway Hobby — SMTP ports are blocked)
  BREVO_API_KEY: Joi.string().allow('').optional(),

  // Frontend URL (for password reset / email verify links)
  FRONTEND_URL: Joi.string().uri().required(),

  // Public base URL of this API (used for avatar/file absolute links)
  API_PUBLIC_URL: Joi.string().uri().required(),

  // File storage
  STORAGE_DRIVER: Joi.string().valid('local', 's3').default('local'),
  UPLOAD_DIR: Joi.string().default('./uploads'),
  MAX_FILE_SIZE_MB: Joi.number().default(10),

  // S3 / S3-compatible (optional — only required when STORAGE_DRIVER=s3)
  S3_BUCKET: Joi.string().optional(),
  S3_REGION: Joi.string().optional(),
  S3_ACCESS_KEY_ID: Joi.string().optional(),
  S3_SECRET_ACCESS_KEY: Joi.string().optional(),
  S3_ENDPOINT: Joi.string().optional(),
});
