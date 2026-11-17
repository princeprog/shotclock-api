import {
	PostgresDialect,
} from 'kysely'
import { Pool } from 'pg'
import { defineConfig } from 'kysely-ctl'
import { databaseSsl } from '../src/database/database-ssl'

// Migrations may run as a separate owner role (DB_MIGRATION_*) while the API uses a least-privilege runtime role.
export default defineConfig({
	dialect: new PostgresDialect({
		pool: new Pool({
			host: process.env.DB_HOST,
			port: Number.parseInt(process.env.DB_PORT ?? "5432"),
			user: process.env.DB_MIGRATION_USER || process.env.DB_USER,
			password: process.env.DB_MIGRATION_PASSWORD || process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
			ssl: databaseSsl({ get: (key) => process.env[key] }),
		})
	}),
	migrations: {
		migrationFolder: "../src/database/migrations"
	},
})

