// apps/api/src/services/pricingService.js
// Simple pricing engine: base + per mile + options
async function estimate({ miles = 1, vehicleType = 'car', fragile = false, priority = 'standard', region = 'default' }) {
  const base = vehicleType === 'van' ? 12 : 8;
  const perMile = vehicleType === 'van' ? 2.0 : 1.2;
  let total = base + miles * perMile;

  if (fragile) total += 5;
  if (priority === 'rush') total += 8;
  // region adjustments
  if (region === 'tx' || region === 'wa') total *= 1.05;

  return {
    currency: 'USD',
    total: Number(total.toFixed(2)),
    breakdown: { base, perMile, miles, fragileFee: fragile ? 5 : 0, priorityFee: priority === 'rush' ? 8 : 0 }
  };
}

module.exports = {
  estimate
};
