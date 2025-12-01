// src/index.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();

// Routers
const quoteRouter = require('./routes/quote');
const ordersRouter = require('./routes/orders');
const vehiclesRouter = require('./routes/vehicles');
const notaryRouter = require('./routes/notary');
const adminRouter = require('./routes/admin');
const pricingRouter = require('./routes/pricing');
const schedulingRouter = require('./routes/scheduling');
const courierRouter = require('./routes/courier');
const driversRouter = require('./routes/drivers');
const paymentRouter = require('./routes/paymentRoutes');
const sheetsRouter = require('./routes/sheetsRoutes');

const PORT = process.env.PORT || 3000;
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    message: "Smiles In Route API",
    status: "healthy",
    timestamp: new Date(),
    version: "2.0"
  });
});

// Routes
app.use('/api/quote', quoteRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/vehicles', vehiclesRouter);
app.use('/api/notary', notaryRouter);
app.use('/api/admin', adminRouter);
app.use('/api/pricing', pricingRouter);
app.use('/api/scheduling', schedulingRouter);
app.use('/api/courier', courierRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/payment', paymentRouter);
app.use('/api/sheets', sheetsRouter);

// Default 404
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: "Internal server error", details: err.message });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Smiles API running on port ${PORT}`);
});
