// src/routes/orders.js
const express = require('express');
const router = express.Router();

// We'll need the database pool and body parser
const pool = require('../utils/db');

// GET all orders
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT o.*, c.first_name, c.last_name, c.email, s.service_name, v.vehicle_type, nd.document_name
            FROM orders o
            JOIN customers c ON o.customer_id = c.customer_id
            JOIN services s ON o.service_id = s.service_id
            LEFT JOIN vehicles v ON o.vehicle_id = v.vehicle_id
            LEFT JOIN notary_documents nd ON o.document_id = nd.document_id
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET single order
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(`
            SELECT o.*, c.first_name, c.last_name, c.email, s.service_name, v.vehicle_type, nd.document_name
            FROM orders o
            JOIN customers c ON o.customer_id = c.customer_id
            JOIN services s ON o.service_id = s.service_id
            LEFT JOIN vehicles v ON o.vehicle_id = v.vehicle_id
            LEFT JOIN notary_documents nd ON o.document_id = nd.document_id
            WHERE o.order_id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching order:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST create new order
router.post('/', async (req, res) => {
    const body = req.body;

    try {
        // Check if customer exists
        let customerId;
        const existingCustomer = await pool.query('SELECT customer_id FROM customers WHERE email = $1', [body.email]);

        if (existingCustomer.rows.length > 0) {
            customerId = existingCustomer.rows[0].customer_id;
        } else {
            const customerResult = await pool.query(`
                INSERT INTO customers (first_name, last_name, email, phone, street_address, city, state, zip_code)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                RETURNING customer_id
            `, [
                body.first_name, body.last_name, body.email, body.phone,
                body.street_address, body.city, body.state, body.zip_code
            ]);
            customerId = customerResult.rows[0].customer_id;
        }

        // Insert order
        const orderQuery = `
            INSERT INTO orders (
                customer_id, service_id, vehicle_id, document_id,
                pickup_address, delivery_address, appointment_address,
                distance_miles, priority, num_packages, num_signatures,
                batch_id, contract_id,
                base_cost, distance_cost, priority_fee, signature_fee,
                travel_fee, discount, total_cost, status
            ) VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
            ) RETURNING *
        `;

        const orderValues = [
            customerId, body.service_id, body.vehicle_id || null, body.document_id || null,
            body.pickup_address || null, body.delivery_address || null, body.appointment_address || null,
            body.distance_miles || 0, body.priority || false, body.num_packages || 1,
            body.num_signatures || 1, body.batch_id || null, body.contract_id || null,
            body.base_cost || 0, body.distance_cost || 0, body.priority_fee || 0,
            body.signature_fee || 0, body.travel_fee || 0, body.discount || 0,
            body.total_cost || 0, 'pending'
        ];

        const result = await pool.query(orderQuery, orderValues);
        res.status(201).json(result.rows[0]);

    } catch (err) {
        console.error('Error creating order:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT update order status
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const completedAt = status === 'completed' ? new Date() : null;

        const result = await pool.query(`
            UPDATE orders SET status = $1, completed_at = $2
            WHERE order_id = $3 RETURNING *
        `, [status, completedAt, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating order:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE order (admin only)
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM orders WHERE order_id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        res.json({ message: 'Order deleted successfully', order: result.rows[0] });
    } catch (err) {
        console.error('Error deleting order:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

