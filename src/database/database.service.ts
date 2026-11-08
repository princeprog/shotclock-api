import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg'
import { DB } from './db';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy{
    private readonly logger = new Logger(DatabaseService.name);
    readonly db: Kysely<DB>;

    constructor(config: ConfigService){
        const port = Number(config.getOrThrow<string>('DB_PORT'));
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DB_PORT');
        const pool = new Pool ({
            host: config.getOrThrow<string>('DB_HOST'),
            port,
            user: config.getOrThrow<string>('DB_USER'),
            password: config.getOrThrow<string>('DB_PASSWORD'),
            database: config.getOrThrow<string>('DB_NAME')
        });
        pool.on('error', (error: Error) => {
            this.logger.error('Unexpected database connection error', error.stack);
        });

        this.db = new Kysely<DB>({
            dialect: new PostgresDialect({pool}),
        })
    }

    async onModuleInit(): Promise<void>{
        await sql`SELECT 1`.execute(this.db)
        this.logger.log('Connected to PostgreSQL')
    }

    async onModuleDestroy(): Promise<void> {
        await this.db.destroy();
    }

}
