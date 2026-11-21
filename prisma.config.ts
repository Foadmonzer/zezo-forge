import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Local placeholder only. Supply a real connection string through DATABASE_URL after choosing a database.
    url: process.env.DATABASE_URL || 'postgresql://127.0.0.1:5432/zezo_forge?schema=public'
  }
});
