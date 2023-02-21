const mongoose = require('mongoose');

const WhitelistSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true
    }
});

mongoose.model('Whitelist', WhitelistSchema);
