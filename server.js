// apps/api/server.js
// Render runs this entry. It mounts the scheduling router.
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

const schedulingRouter = require('./scheduling-server');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.use('/scheduling', schedulingRouter);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Smiles In Route API', routes: ['/scheduling'] });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
