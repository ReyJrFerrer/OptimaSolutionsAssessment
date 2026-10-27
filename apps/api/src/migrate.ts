import { Store } from './db/store.js';
const store = new Store(process.env.DATABASE_PATH ?? './data/orders.sqlite');
store.close();
console.log('SQLite migrations applied');
