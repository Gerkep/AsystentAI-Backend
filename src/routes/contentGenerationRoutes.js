const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const OpenAI = require('openai');
const { Configuration, OpenAIApi } = OpenAI;
const requireTokens = require('../middlewares/requireTokens');
const requireTestTokens = require('../middlewares/requireTestTokens');
require('dotenv').config();
const Transaction = mongoose.model('Transaction');

const configuration = new Configuration({
    organization: "org-BurBlbC5xPRFDGqoCf19IkW8",
    apiKey: process.env.OPENAI_API_KEY
});

const openai = new OpenAIApi(configuration);

router.post('/askAI', requireTokens, async (req, res) => {
    try {
        const { prompt, title } = req.body;
        const user = req.user;
        const response = await openai.createCompletion({
            model: "text-davinci-003",
            prompt: `Jesteś copywriterem i generujesz genialne treści. ${prompt}`,
            max_tokens: 3000,
            temperature: 0.7,
            frequency_penalty: 0.4
        });

        // Decrease token balance
        user.tokenBalance -= response.data.usage.total_tokens;

        const transaction = new Transaction({
            value: response.data.usage.total_tokens,
            title: title,
            type: "expense",
            timestamp: Date.now()
        });

        user.transactions.push(transaction);
        
        user.tokenHistory.push({
            timestamp: Date.now(),
            balance: user.tokenBalance
        });

        await user.save();
        await transaction.save();
        return res.status(201).json({ response: response.data.choices[0].text, tokens: response.data.usage.total_tokens });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
});

router.post('/testAskAI', requireTestTokens, async (req, res) => {
    try {
        const { text, conversationContext } = req.body;
        const user = req.user;

        const response = await openai.createCompletion({
            model: "text-davinci-003",
            prompt: `Jesteś wszechwiedzącym, przyjaznym i pomocnym asystentem AI. Rozmawiasz ze znajomym. Nie zaczynaj od nowej linii.
            ${conversationContext}
            Znajomy: ${text}
            Asystent:`,
            max_tokens: 3000,
            temperature: 0.1,
            frequency_penalty: 0.45
        });

        user.testTokenBalance -= response.data.usage.total_tokens;

        await user.save();

        return res.status(201).json({ response: response.data.choices[0].text });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
});

router.post('/ligaAskAI', async (req, res) => {
    try {
        const { text, conversationContext } = req.body;

        const response = await openai.createCompletion({
            model: "text-davinci-003",
            prompt: `Jesteś Ignacym Łukasiewiczem. Prowadzisz rozmowę z uczniem odpowiadając na jego pytania i wiadomości w uprzejmy sposób. Odpowiadasz tylko za Ignacego.
            ${conversationContext}
            Uczeń: ${text}
            Ignacy:`,
            max_tokens: 2500,
            temperature: 0.7,
            frequency_penalty: 0.4
        });

        return res.status(201).json({ response: response.data.choices[0].text });

    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
});

module.exports = router;