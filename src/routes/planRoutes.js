const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const requireAuth = require('../middlewares/requireAuth');
const requireAdmin = require('../middlewares/requireAdmin');
const Plan = mongoose.model('Plan');
const User = mongoose.model('User');

router.get('/getPlans', async (req, res) => {
    try {
        const plans = await Plan.find();
        res.json(plans);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.get('/getPlan/:id', async (req, res) => {
    try {
        const plan = await Plan.findById(req.params.id);
        if (!plan) {
            return res.status(404).json({ message: 'Plan not found' });
        }
        res.json(plan);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.post('/createPlan', requireAdmin, async (req, res) => {
    try {
        const { name, type, tokenPrice, monthlyTokens, price, accountLimit } = req.body;
        const plan = new Plan({ name, type, tokenPrice, monthlyTokens, price, accountLimit });

        await plan.save();
        res.status(201).json(plan);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

//allow only admin to update the plan
router.patch('/updatePlan/:id', requireAdmin, async (req, res) => {
    try {
        const plan = await Plan.findById(req.params.id);
        if (!plan) {
            return res.status(404).json({ message: 'Plan not found' });
        }
        const { name, monthlyTokens, price } = req.body;
        plan.name = name;
        plan.monthlyTokens = monthlyTokens;
        plan.price = price;

        await plan.save();
        res.json(plan);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



//allow only admin to delete the plan
router.delete('/deletePlan/:id', requireAdmin, async (req, res) => {
    try {
        const deletedPlan = await Plan.findByIdAndDelete(req.params.id);
        if (!deletedPlan) return res.status(404).json({ message: 'Plan not found' });
        return res.json({ message: 'Plan deleted' });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
});

router.patch('/updateUserPlan', requireAuth, async (req, res) => {

    const plan = await Plan.findById(req.body.planId);

    if (!plan) {
        return res.status(404).json({ message: 'Plan not found' });
    }

    User.findByIdAndUpdate(req.user._id, { $set: { plan: req.body.planId } }, { new: true }, async (err, user) => {
        if (err) {
            return res.status(500).send(err);
        }

        user.tokenBalance = plan.monthlyTokens;

        await user.save();
        return res.json(user);
    });
});


module.exports = router;