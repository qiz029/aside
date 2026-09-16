import type { MediaContainer } from "./index.js";
export interface AnalysisJob {
  episodeId: string;
}
export interface Env {
  LIVE: DurableObjectNamespace<import("./live-supervisor.js").LiveSupervisor>;
  AI_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  DB: D1Database;
  AUDIO: R2Bucket;
  ASSETS: Fetcher;
  ANALYSIS: Workflow<AnalysisJob>;
  MEDIA: DurableObjectNamespace<MediaContainer>;
  SESSION_SECRET: string;
  /** Comma-separated HMAC IP keys exempt from daily voice/question trial quotas. */
  TRIAL_TEST_IP_HASHES?: string;
  EMAIL?: SendEmail;
  AUTH_EMAIL_FROM?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OPENAI_API_KEY?: string;
  ASIDE_BACKEND_MODEL?: string;
  /** Shared secret for /api/admin/*. Unset leaves those routes unmounted. */
  ADMIN_KEY?: string;
  APP_ORIGIN: string;
  ALLOW_UPLOADS?: string;
  MONTHLY_UPLOAD_LIMIT?: string;
  GLOBAL_DAILY_UPLOAD_LIMIT?: string;
  ACCOUNT_STORAGE_LIMIT_BYTES?: string;
  GLOBAL_STORAGE_LIMIT_BYTES?: string;
  /** Segments transcribed and analysed at once; defaults to 6. */
  ANALYSIS_CONCURRENCY?: string;
}
