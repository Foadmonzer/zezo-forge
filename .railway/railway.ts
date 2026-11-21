import { bucket, defineRailway, github, postgres, project, service } from "railway/iac";

const repository = "Foadmonzer/zezo-forge";
const source = (branch: string) => github(repository, { branch });
const branch = "codex/nextjs-migration-20261104";

export default defineRailway(() => {
  const db = postgres("zezo-postgres");
  const backupStore = bucket("zezo-encrypted-backups", { region: "iad" });

  const web = service("zezo-web", {
    source: source(branch),
    start: "pnpm start -- --hostname 0.0.0.0 --port $PORT",
    preDeploy: "pnpm db:migrate:deploy",
    healthcheck: "/api/health",
    healthcheckTimeout: 30,
    env: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: db.env.DATABASE_URL,
      ZEZO_DISABLE_ADMIN_SETUP: "true",
      ZEZO_ENABLE_EMAIL_DELIVERY: "false",
      ZEZO_TRUST_PROXY: "1",
      ZEZO_DATABASE_POOL_SIZE: "8",
    },
  });

  const mailWorker = service("zezo-mail-worker", {
    source: source(branch),
    start: "pnpm worker:mail",
    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,
      ZEZO_DISABLE_ADMIN_SETUP: "true",
      ZEZO_ENABLE_EMAIL_DELIVERY: "false",
      ZEZO_DATABASE_POOL_SIZE: "2",
    },
  });

  const backupJob = service("zezo-encrypted-postgres-backup", {
    source: source(branch),
    start: "pnpm backup:railway",
    deploy: { cronSchedule: "0 3 * * *", restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3 },
    env: {
      NODE_ENV: "production",
      DATABASE_URL: db.env.DATABASE_URL,
      ZEZO_BACKUP_S3_ENDPOINT: backupStore.env.ENDPOINT,
      ZEZO_BACKUP_S3_BUCKET: backupStore.env.BUCKET,
      ZEZO_BACKUP_S3_ACCESS_KEY_ID: backupStore.env.ACCESS_KEY_ID,
      ZEZO_BACKUP_S3_SECRET_ACCESS_KEY: backupStore.env.SECRET_ACCESS_KEY,
      ZEZO_BACKUP_S3_REGION: backupStore.env.REGION,
      ZEZO_BACKUP_S3_URL_STYLE: "virtual",
    },
  });

  return project("zezo-forge", { resources: [db, backupStore, web, mailWorker, backupJob] });
});
