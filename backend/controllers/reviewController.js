const {getMongo} = require("../mongo");

const createReview = async (req, res) => {
    const {product_id, rating, review_text} = req.body;
    if(!product_id || !rating || !review_text){
        return res.status(400).json({message: "Product ID, Rating and Review text are required"});
    }
    if(rating < 1 || rating > 5){
        return res.status(400).json({message: "rating must be between 1 and 5"});
    }
    try{
        const mongo = getMongo();
        const result = await mongo.collection("product_reviews").insertOne({
            product_id: parseInt(product_id),
            user_id: req.user.id,
            first_name: req.user.email.split("@")[0],
            rating: parseInt(rating),
            review_text,
            created_at: new Date()
        });
        res.status(201).json({message: "review submitted", reviewId: result.insertedId});
    }catch(err){
        res.status(500).json({message: "Server Error"});
    }
};

module.exports = {createReview};