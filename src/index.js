const express = require('express');
const pool = require('../../shared/db');       // shared db.js (optional read-only)
const config = require('../../shared/config'); // shared config.js
const { generateToken, verifyToken } = require('../../shared/auth');
const { logError, logInfo } = require('../../shared/utils');
const { USER_ROLES, DELIVERY_STATUS } = require('../../shared/constants');

const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('✅ api portal running'));

const PORT = config.PORT || 3001;
app.listen(PORT, () => logInfo(`API portal listening on port ${PORT}`));
