require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { connectMongo, getMongo} = require("./mongo");
const authenticateToken = require('./middleware/authenticateToken');
const authorizeRole     = require('./middleware/authorizeRole');
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({ message: "era-commerce API is running" });
});

// post/login
app.post("/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: "Email and Password are required" });
    }
    const sql = "SELECT * FROM users WHERE email = ?";
    db.query(sql, [email], async (err, results) => {
        if (err) return res.status(500).json({ message: "Server error" });
        if (results.length === 0) {
            return res.status(401).json({ message: "Invalid email or password" });
        }
        const user = results[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: "Invalid email or password" });
        }
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN }
        );
        res.json({
            message: "Login Successful",
            token,
            user: {
                id: user.id,
                first_name: user.first_name,
                last_name: user.last_name,
                email: user.email,
                role: user.role
            }
        });
    });
});

// post/users (register)
app.post("/users", async (req, res) => {
    const {first_name, last_name, email, password} = req.body;
    if(!first_name || !last_name || !email || !password) {
        return res.status(400).json ({message: "ALL Fields are Required"});
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = "INSERT INTO users (first_name, last_name, email, password) VALUES (?, ?, ?, ?)";
        db.query(sql, [first_name, last_name, email, hashedPassword], (err, result) => {
            if(err) {
                if(err.code === "ER_DUP_ENTRY") {
                    return res.status(400).json ({message: "Email already registered"});
                }
                return res.status(500).json ({message: "Server Error"});
            }
            res.status(201).json ({message: "User Registered Successfully", userId: result.insertId});
        });
    } catch (err) {
        res.status(500).json ({message: "Server Error"})
    }
});

// get/ products
app.get("/products", authenticateToken, (req, res) => {
    const sql = "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id = c.id ORDER BY p.id ASC";
    db.query(sql, (err, results) => {
        if(err) return res.status(500).json ({message: "Server Error"});
        res.json(results);
    });
});

// get /products/category/:categoryId
app.get("/products/category/:categoryId", authenticateToken, (req, res) =>{
    const {categoryId} = req.params;
    const sql = "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id = c.id WHERE p.category_id = ? ORDER BY p.id ASC";
    db.query(sql, [categoryId], (err, results) => {
        if (err) return res.status(500).json ({message: "Server Error"});
        res.json(results);
    });
});

// get /products/:id
app.get("/products/:id", authenticateToken, async (req, res) => {
    const {id} = req.params;
    const sql = "SELECT p.id, p.name, p.description, p.price, p.stock_quantity, c.name AS category_name FROM products p INNER JOIN categories c ON p.category_id = c.id WHERE p.id = ?";
    db.query (sql, [id], async (err, results) => {
        if(err) return res.status(500) ({message: "Server Error"});
        if(results.length === 0){
        return res.status(404).json({message: "Product Not Found"});
        }
        const product = results[0];
        try{
            const mongo = getMongo();
            const reviews = await mongo.collection("product_reviews").find({product_id: parseInt(id)}).toArray();
            res.json({...product, reviews});
        }catch(mongoErr){
            res.json({...product, reviews: []});
        }
    });
});

// get /categories
app.get("/categories", authenticateToken, (req, res) => {
    const sql = "SELECT c.id, c.name, c.description, COUNT(p.id) AS product_count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id, c.name, c.description ORDER BY c.id ASC";
    db.query(sql, (err, results) => {
        if(err) return res.status(500).json ({message: "Server Error"});
        res.json(results);
    });
});

// post /products-Admin only
app.post("/products", authenticateToken, authorizeRole("admin"), async (req, res) => {
    const {name, description, price, stock_quantity, category_id} = req.body;
    if(!name || !price || !category_id){
        return res.status(400).json({message:"Name, price and category ID are required"});
    }
    const sql = "INSERT INTO products(name, description, price, stock_quantity, category_id) VALUES (?, ?, ?, ?, ?)";
    db.query (sql, [name, description, price, stock_quantity || 0, category_id], async (err, result) => {
        if(err) return res.status(500).json({message: "Server Error"});
        try{
            const mongo = getMongo();
            await mongo.collection("inventory_logs").insertOne({
                product_id: result.insertId,
                product_name: name,
                action: "restocked",
                quantity_change: stock_quantity || 0,
                previous_stock: 0,
                new_stock: stock_quantity || 0,
                timestamp: new Date() 
            });
        }catch(mongoErr){
            console.error("mongodb log failed:", mongoErr.message);
        }
        res.status(201).json({message: "Product Created", productId: result.insertId});
    });
});

// post /orders
app.post("/orders", authenticateToken, async (req, res) => {
    const {items} = req.body || {};
    const userId = req.user.id;
    if(!items || items.length === 0){
        return res.status(400).json({message: "order must contain Atleast one item"});
    }
    db.beginTransaction (async(err) => {
        if(err) return res.status(500).json({message: "Server Error"});
        try{
            //Step 1: Calculate total amount
            let totalAmount = 0;
            for (const item of items){
                totalAmount += item.price_at_purchase * item.quantity;
            }
            // Step 2: Insert Into orders
            const orderSql = "INSERT INTO orders(user_id, total_amount) VALUES (?, ?)";
            const orderResult = await new Promise((resolve, reject) => {
                db.query (orderSql, [userId, totalAmount], (err, result) => {
                    if (err) reject(err); else resolve(result);
                });
            });
            const orderId = orderResult.insertId;
            
            //Step 3: Insert order_items and update stock
            for (const item of items){
                const {product_id, quantity, price_at_purchase} = item;
                const subtotal = quantity * price_at_purchase;
                
                await new Promise((resolve, reject) => {
                    const itemSql = "INSERT INTO order_items(order_id, product_id, quantity, price_at_purchase, subtotal) VALUES (?, ?, ?, ?, ?)";
                    db.query (itemSql, [orderId, product_id, quantity, price_at_purchase, subtotal], (err, r) => {
                        if(err) reject(err); else resolve (r);
                    });
                });
                
                await new Promise ((resolve, reject) => {
                    const stockSql = "UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?";
                    db.query (stockSql, [quantity, product_id, quantity], (err, r) => {
                        if (err) reject (err);
                        else if(r.affectedRows === 0) reject(new Error("Insufficient Stock"));
                        else resolve(r);
                    });
                });
            }
            
            //Step 4: Commit
            db.commit(async(err) => {
                if(err){
                    return db.rollback(() => {
                        res.status(500).json({message: "Commit Failed"});
                    });
                }
                
                //Step 5: Auto log to MongoDB after commit
                try{
                    const mongo = getMongo();
                    for(const item of items){
                        await mongo.collection("inventory_logs").insertOne({
                            product_id: item.product_id,
                            action: "Sold",
                            quantity_change: -item.quantity,
                            timestamp: new Date()
                        });
                    }
                }catch(mongoErr){
                    console.error("MongoDB log Failed:", mongoErr.message);
                }
                res.status(201).json({message: "Order Placed", orderId});
            });
        }catch(err){
            //Step 6: Rollback on any error
            db.rollback(() => {
                res.status(400).json({message: err.message || "Order Failed"});
            });
        }
    });
});

// get /orders
app.get("/orders", authenticateToken, (req, res) => {
    let sql;
    let params;
    if(req.user.role === "admin"){
        sql = "SELECT o.id, o.status, o.total_amount, o.created_at, u.first_name, u.last_name, u.email FROM orders o INNER JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC";
        params = [];
    }else{
        sql = "SELECT id, status, total_amount, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC";
        params = [req.user.id];
    }
    db.query(sql, params, (err, results) => {
        if(err) return res.status(500).json({message: "Server Error"});
        res.json(results);
    });
});

async function startServer() {
    await connectMongo();
    app.listen(PORT, () => {
        console.log(`Server running at HTTP://localhost:${PORT}`);
    });
}

startServer();
