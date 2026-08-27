const mysql = require("mysql2");
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if(err) {
        console.error("MYSQL connection failed:", err.message);
        process.exit(1);
    }
    console.log("MYSQL connected");
});

module.exports = db;
