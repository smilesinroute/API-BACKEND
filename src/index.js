// apps/api/src/index.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const bookingsRouter = require('./routes/bookings');
const schedulingRouter = require('./routes/scheduling');
const driversRouter = require('./routes/drivers');
const pricingRouter = require('./routes/pricing');
const adminRouter = require('./routes/admin');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));

// Health check
app.get('/', (req, res) => {
  res.json({ status: '✅ API portal running', timestamp: new Date() });
});

// Mount routers
app.use('/api/bookings', bookingsRouter);
app.use('/api/scheduling', schedulingRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/pricing', pricingRouter);
app.use('/api/admin', adminRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('API error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🟢 API portal listening on port ${PORT}`));

module.exports = app;
