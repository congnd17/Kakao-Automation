import * as dotenv from 'dotenv';

dotenv.config();

export interface EnvConfig {
  baseURL: string;
  apiBaseURL: string;
  testEmail: string;
  testPassword: string;
  headless: boolean;
  defaultTimeout: number;
  authToken: string;
  authIdToken: string;
  authTokenExpires: string;
  oktaRefreshToken: string;
  oktaIssuer: string;
  oktaClientId: string;
}

function readEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env: EnvConfig = {
  baseURL: readEnv('BASE_URL', ''),
  apiBaseURL: readEnv('API_BASE_URL', 'https://dev-settlement-admin-api.berriz.in'),
  testEmail: readEnv('TEST_EMAIL', ''),
  testPassword: readEnv('TEST_PASSWORD', ''),
  headless: readEnv('HEADLESS', 'false') === 'true',
  defaultTimeout: Number(readEnv('DEFAULT_TIMEOUT', '15000')),
  authToken: readEnv('AUTH_TOKEN', ''),
  authIdToken: readEnv('AUTH_ID_TOKEN', ''),
  authTokenExpires: readEnv('AUTH_TOKEN_EXPIRES', ''),
  oktaRefreshToken: readEnv('OKTA_REFRESH_TOKEN', ''),
  oktaIssuer: readEnv('OKTA_ISSUER', 'https://kakaoent.okta.com'),
  oktaClientId: readEnv('OKTA_CLIENT_ID', '0oas1vvm51SaMtcMF697'),
};
