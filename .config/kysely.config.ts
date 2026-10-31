import {
	PostgresDialect,
} from 'kysely'
import { Pool } from 'pg'
import { defineConfig } from 'kysely-ctl'

export default defineConfig({
	dialect: new PostgresDialect({
		pool: new Pool({
			host: process.env.DB_HOST,
			port: Number.parseInt(process.env.DB_PORT ?? "5432"),
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		})
	}),
	migrations: {
		migrationFolder: "../src/database/migrations"
	},
})
