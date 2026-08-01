import { config } from './env';

export const databaseConfig = {
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  ssl: config.db.ssl,
  pool: {
    min: config.db.poolMin,
    max: config.db.poolMax,
  },
};
