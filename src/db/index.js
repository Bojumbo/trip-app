'use strict';

const Database = require('better-sqlite3');
const config = require('../config');
const { initSchema } = require('./schema');

config.ensureDataDir();

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

initSchema(db);

module.exports = db;
