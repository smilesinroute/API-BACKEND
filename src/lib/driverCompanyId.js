"use strict";

function formatDriverCompanyId(number) {
  return number == null ? null : "SIR-" + String(number).padStart(4, "0");
}

module.exports = { formatDriverCompanyId };
