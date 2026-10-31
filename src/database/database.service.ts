import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool } from 'pg'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy{
    private readonly logger = new Logger(DatabaseService.name);
    readonly pool: Pool;

    constructor(config: ConfigService){
        this.pool = new Pool ({
            host: config.getOrThrow<string>('DB_HOST'),
            port: Number(config.getOrThrow<string>('DB_PORT')),
            user: config.getOrThrow<string>('DB_USER'),
            password: config.getOrThrow<string>('DB_PASSWORD'),
            database: config.getOrThrow<string>('DB_NAME')
        });
        this.pool.on('error', (error: Error) => {
            this.logger.error('Unexpected database connection error', error.stack);
        });
    }

    async onModuleInit(): Promise<void>{
        await this.pool.query('Select 1');
        this.logger.log('Connected to PostgreSQL')
    }

    async onModuleDestroy(): Promise<void> {
        await this.pool.end();
    }

}