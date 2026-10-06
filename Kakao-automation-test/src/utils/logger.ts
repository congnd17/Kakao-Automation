import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const logDir = path.join('reports', 'logs');
fs.mkdirSync(logDir, { recursive: true });

// Chỉ ghi ra file — KHÔNG dùng Console transport để tránh Playwright/Allure
// tự động capture stdout và đính kèm vào report (vi phạm reporting_rules.md mục 4).
export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`),
  ),
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'test-execution.log') }),
  ],
});
