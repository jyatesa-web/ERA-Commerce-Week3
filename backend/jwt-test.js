const jwt = require("jsonwebtoken");
const secret = "eracommerce_jwt_secret_2026";

// Generate a Token
const payload = {
    id: 3,
    email: "john@eracommerce.com",
    role: "customer"
};
const token = jwt.sign(payload, secret, {expiresIn: "24h"});
console.log("Token:", token);

// Verify and decode the token
const decoded = jwt.verify(token, secret);
console.log("Decoded:", decoded);
