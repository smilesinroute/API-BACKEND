// Content Management API for Live Editing
// This handles saving and loading editable content for all portals

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware to verify admin access
const verifyAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Get content for a specific portal
router.get('/content/:portal', async (req, res) => {
  try {
    const { portal } = req.params;
    
    const { data, error } = await supabase
      .from('portal_content')
      .select('*')
      .eq('portal', portal)
      .order('category', { ascending: true });

    if (error) throw error;

    // If no content exists, return default content
    if (!data || data.length === 0) {
      const defaultContent = getDefaultContent(portal);
      res.json(defaultContent);
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

// Update content for a specific portal (admin only)
router.post('/content/:portal', verifyAdmin, async (req, res) => {
  try {
    const { portal } = req.params;
    const content = req.body;

    // Delete existing content for this portal
    await supabase
      .from('portal_content')
      .delete()
      .eq('portal', portal);

    // Insert new content
    const { data, error } = await supabase
      .from('portal_content')
      .insert(content.map((item) => ({
        ...item,
        portal,
        updated_at: new Date().toISOString(),
        updated_by: req.user.id
      })));

    if (error) throw error;

    // Log the content update
    await supabase
      .from('content_history')
      .insert({
        portal,
        action: 'update',
        content_count: content.length,
        updated_by: req.user.id,
        timestamp: new Date().toISOString()
      });

    res.json({ success: true, message: 'Content updated successfully' });
  } catch (error) {
    console.error('Error updating content:', error);
    res.status(500).json({ error: 'Failed to update content' });
  }
});

// Get content by category and item ID
router.get('/content/:portal/:category/:itemId', async (req, res) => {
  try {
    const { portal, category, itemId } = req.params;
    
    const { data, error } = await supabase
      .from('portal_content')
      .select('*')
      .eq('portal', portal)
      .eq('category', category)
      .eq('id', itemId)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching content item:', error);
    res.status(500).json({ error: 'Content item not found' });
  }
});

// Admin login endpoint
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // In production, verify against your user database
    // For now, using environment variables for admin credentials
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      const token = jwt.sign(
        { 
          id: 'admin-1', 
          email, 
          role: 'admin' 
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({ 
        success: true, 
        token,
        user: { id: 'admin-1', email, role: 'admin' }
      });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get content history (admin only)
router.get('/admin/content-history', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('content_history')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error fetching content history:', error);
    res.status(500).json({ error: 'Failed to fetch content history' });
  }
});

// Helper function to get default content
function getDefaultContent(portal) {
  const baseContent = [
    {
      id: 'hero-title',
      type: 'text',
      label: 'Hero Title',
      value: 'Professional Mobile Notary & Document Services',
      category: 'hero',
      portal
    },
    {
      id: 'hero-subtitle',
      type: 'text',
      label: 'Hero Subtitle',
      value: 'Available Schedule Preparation • Honest Pricing • Small Black-Owned Business',
      category: 'hero',
      portal
    },
    {
      id: 'company-phone',
      type: 'text',
      label: 'Company Phone',
      value: '(555) 123-4567',
      category: 'contact',
      portal
    },
    {
      id: 'company-email',
      type: 'text',
      label: 'Company Email',
      value: 'hello@smilesinroute.com',
      category: 'contact',
      portal
    },
    {
      id: 'business-address',
      type: 'text',
      label: 'Business Address',
      value: '123 Business St, City, State 12345',
      category: 'contact',
      portal
    }
  ];

  // Add portal-specific content
  if (portal === 'customer') {
    baseContent.push(
      {
        id: 'notary-price',
        type: 'pricing',
        label: 'Mobile Notary Price',
        value: '$25 base + $15 per signature',
        category: 'pricing',
        portal
      },
      {
        id: 'courier-price',
        type: 'pricing',
        label: 'Document Courier Price',
        value: '$20 + $2 per mile',
        category: 'pricing',
        portal
      },
      {
        id: 'why-choose-title',
        type: 'text',
        label: 'Why Choose Us Title',
        value: 'Why Choose Smiles in Route?',
        category: 'about',
        portal
      },
      {
        id: 'why-choose-description',
        type: 'text',
        label: 'Why Choose Us Description',
        value: 'Small Black-owned business committed to professional, reliable service with honest pricing and available schedule preparation.',
        category: 'about',
        portal
      }
    );
  }

  return baseContent;
}

module.exports = router;
