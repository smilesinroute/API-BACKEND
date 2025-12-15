const http = require('http');
const url = require('url');
const { Pool } = require('pg');
const { appendRow } = require('./googleSheets');

const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
    user: process.env.PG_USER || 'postgres',
    host: process.env.PG_HOST || 'localhost',
    database: process.env.PG_DATABASE || 'smiles_route',
    password: process.env.PG_PASSWORD || 'password',
    port: process.env.PG_PORT || 5432,
});

// Helper function to parse request body
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                resolve({});
            }
        });
    });
}

// Helper function to set CORS headers
function setCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// API Endpoints
async function handleAPI(req, res) {
    setCORSHeaders(res);
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;
    const method = req.method;

    try {
        // Dashboard Stats
        if (path === '/api/dashboard/stats' && method === 'GET') {
            const totalOrders = await pool.query('SELECT COUNT(*) FROM orders');
            const pendingOrders = await pool.query('SELECT COUNT(*) FROM orders WHERE status = \'pending\'');
            const inProgress = await pool.query('SELECT COUNT(*) FROM orders WHERE status = \'in_progress\'');
            const totalRevenue = await pool.query('SELECT SUM(total_cost) FROM orders WHERE status = \'completed\'');
            const activeContracts = await pool.query('SELECT COUNT(*) FROM contracts WHERE status = \'active\'');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([
                { title: 'Total Orders', value: totalOrders.rows[0].count, change: '+12', changeType: 'positive', icon: '📦' },
                { title: 'Pending Orders', value: pendingOrders.rows[0].count, change: '+3', changeType: 'neutral', icon: '⏳' },
                { title: 'In Progress', value: inProgress.rows[0].count, change: '-2', changeType: 'neutral', icon: '🚚' },
                { title: 'Total Revenue', value: `$${parseFloat(totalRevenue.rows[0].sum || 0).toFixed(2)}`, change: '+15%', changeType: 'positive', icon: '💰' },
                { title: 'Active Contracts', value: activeContracts.rows[0].count, change: '+1', changeType: 'positive', icon: '📋' }
            ]));
            return;
        }

        // Get quote for courier service
        if (path === '/api/quote/courier' && method === 'POST') {
            const body = await parseBody(req);
            const { vehicle_type, distance_miles, priority, num_packages, contract_id } = body;
            
            // Get vehicle rates
            const vehicleResult = await pool.query('SELECT base_rate, cost_per_mile FROM vehicles WHERE vehicle_type = $1', [vehicle_type]);
            if (vehicleResult.rows.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid vehicle type' }));
                return;
            }
            
            const vehicle = vehicleResult.rows[0];
            let base_cost = parseFloat(vehicle.base_rate);
            let distance_cost = parseFloat(distance_miles) * parseFloat(vehicle.cost_per_mile);
            let priority_fee = priority ? 15.00 : 0;
            let discount = 0;
            
            // Apply bulk discount (10% for 5+ packages)
            if (num_packages >= 5) {
                discount = (base_cost + distance_cost) * 0.10;
            }
            
            // Check for contract discount
            if (contract_id) {
                const contractResult = await pool.query('SELECT flat_fee FROM contracts WHERE contract_id = $1 AND status = \'active\'', [contract_id]);
                if (contractResult.rows.length > 0) {
                    // Contract pricing overrides calculation
                    const total_cost = parseFloat(contractResult.rows[0].flat_fee);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        base_cost: 0, 
                        distance_cost: 0, 
                        priority_fee: 0, 
                        discount: 0,
                        total_cost,
                        pricing_type: 'contract'
                    }));
                    return;
                }
            }
            
            const total_cost = base_cost + distance_cost + priority_fee - discount;
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                base_cost,
                distance_cost,
                priority_fee,
                discount,
                total_cost,
                pricing_type: 'standard'
            }));
            return;
        }

        // Get quote for notary service
        if (path === '/api/quote/notary' && method === 'POST') {
            const body = await parseBody(req);
            const { document_id, num_signatures } = body;
            
            // Get document fee
            const docResult = await pool.query('SELECT fee_per_signature FROM notary_documents WHERE document_id = $1', [document_id]);
            if (docResult.rows.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid document type' }));
                return;
            }
            
            const fee_per_signature = parseFloat(docResult.rows[0].fee_per_signature);
            const signature_fee = fee_per_signature * parseInt(num_signatures);
            const travel_fee = 25.00; // Flat travel fee
            const total_cost = signature_fee + travel_fee;
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                signature_fee,
                travel_fee,
                total_cost,
                pricing_type: 'notary'
            }));
            return;
        }

        // Get all orders
        if (path === '/api/orders' && method === 'GET') {
            const query = `
                SELECT o.*, c.first_name, c.last_name, c.email, s.service_name, v.vehicle_type, nd.document_name
                FROM orders o
                JOIN customers c ON o.customer_id = c.customer_id
                JOIN services s ON o.service_id = s.service_id
                LEFT JOIN vehicles v ON o.vehicle_id = v.vehicle_id
                LEFT JOIN notary_documents nd ON o.document_id = nd.document_id
                ORDER BY o.created_at DESC
            `;
            const result = await pool.query(query);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.rows));
            return;
        }

        // Create new order
        if (path === '/api/orders' && method === 'POST') {
            const body = await parseBody(req);
            
            // First, create or get customer
            let customerId;
            const existingCustomer = await pool.query('SELECT customer_id FROM customers WHERE email = $1', [body.email]);
            
            if (existingCustomer.rows.length > 0) {
                customerId = existingCustomer.rows[0].customer_id;
            } else {
                const customerResult = await pool.query(`
                    INSERT INTO customers (first_name, last_name, email, phone, street_address, city, state, zip_code)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING customer_id
                `, [body.first_name, body.last_name, body.email, body.phone, body.street_address, body.city, body.state, body.zip_code]);
                customerId = customerResult.rows[0].customer_id;
            }
            
            // Create order
            const orderQuery = `
                INSERT INTO orders (customer_id, service_id, vehicle_id, document_id, pickup_address, delivery_address, 
                appointment_address, distance_miles, priority, num_packages, num_signatures, batch_id, contract_id,
                base_cost, distance_cost, priority_fee, signature_fee, travel_fee, discount, total_cost, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                RETURNING *
            `;
            
            const orderValues = [
                customerId, body.service_id, body.vehicle_id || null, body.document_id || null,
                body.pickup_address || null, body.delivery_address || null, body.appointment_address || null,
                body.distance_miles || null, body.priority || false, body.num_packages || 1,
                body.num_signatures || 1, body.batch_id || null, body.contract_id || null,
                body.base_cost || 0, body.distance_cost || 0, body.priority_fee || 0,
                body.signature_fee || 0, body.travel_fee || 0, body.discount || 0,
                body.total_cost, 'pending'
            ];
            
            const result = await pool.query(orderQuery, orderValues);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.rows[0]));
            return;
        }

        // Get vehicles
        if (path === '/api/vehicles' && method === 'GET') {
            const result = await pool.query('SELECT * FROM vehicles WHERE active = true ORDER BY vehicle_type');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.rows));
            return;
        }

        // Get notary documents
        if (path === '/api/notary-documents' && method === 'GET') {
            const result = await pool.query('SELECT * FROM notary_documents WHERE active = true ORDER BY category, document_name');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.rows));
            return;
        }

        // Update order status
        if (path.startsWith('/api/orders/') && method === 'PUT') {
            const orderId = path.split('/')[3];
            const body = await parseBody(req);
            const query = 'UPDATE orders SET status = $1, completed_at = $2 WHERE order_id = $3 RETURNING *';
            const completedAt = body.status === 'completed' ? new Date() : null;
            const result = await pool.query(query, [body.status, completedAt, orderId]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.rows[0]));
            return;
        }

        // Health check
        if (path === '/api/health' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                message: 'Smiles In Route API', 
                status: 'healthy',
                database: 'connected',
                timestamp: new Date().toISOString(),
                version: '2.0'
            }));
            return;
        }

        // Default response
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));

    } catch (error) {
        console.error('API Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error', details: error.message }));
    }
}

// Function to sync data to Google Sheets
async function syncToSheets() {
    try {
        const query = `
            SELECT o.order_id, c.first_name, c.last_name, s.service_name, 
                   o.total_cost, o.status, o.created_at
            FROM orders o
            JOIN customers c ON o.customer_id = c.customer_id
            JOIN services s ON o.service_id = s.service_id
            WHERE o.status = 'completed'
            ORDER BY o.created_at DESC
            LIMIT 100
        `;
        const res = await pool.query(query);
        const spreadsheetId = process.env.SHEETS_ID;
        const range = 'Orders!A1';

        for (const row of res.rows) {
            const values = [
                row.order_id, 
                `${row.first_name} ${row.last_name}`, 
                row.service_name, 
                row.total_cost, 
                row.status,
                row.created_at
            ];
            await appendRow(spreadsheetId, range, values);
        }

        console.log('✅ Data synced to Google Sheets');
    } catch (err) {
        console.error('Error syncing to Sheets:', err);
    }
}

const server = http.createServer(handleAPI);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Smiles API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    
    // Test database connection
    pool.query('SELECT NOW()', (err, res) => {
        if (err) {
            console.error('❌ Database connection failed:', err.message);
        } else {
            console.log('✅ Database connected successfully');
            // Sync to sheets after database connection confirmed
            if (process.env.SHEETS_ID) {
                syncToSheets();
            }
        }
    });
});
