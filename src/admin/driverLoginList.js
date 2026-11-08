"use strict";

const listName = "Smiles In Route Driver Login";

function driverLoginListConfig() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const list = process.env.CLOUDFLARE_DRIVER_EMAIL_LIST_ID?.trim();
  const token = process.env.CLOUDFLARE_DRIVER_LIST_TOKEN?.trim();
  if (!/^[a-f0-9]{32}$/i.test(account ?? "") ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(list ?? "") ||
      !token) return null;

  return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/gateway/lists/${list}`, token };
}

async function allowDriverLogin({ url, token }, email) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(6500);
  async function request(suffix, options) {
    const response = await fetch(url + suffix, { headers, signal, redirect: "error", ...options });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error("Cloudflare list request failed");
    return data;
  }

  const { result: list } = await request("");
  if (list?.type !== "EMAIL" || list.name !== listName) throw new Error("Wrong Cloudflare list");

  const includesEmail = (items) => items?.some((item) => item.value?.toLowerCase() === email);
  if (includesEmail(list.items)) return;
  try {
    await request("", { method: "PATCH", body: JSON.stringify({ append: [{ value: email }] }) });
  } catch (error) {
    // The first attempt may have succeeded even if its response was lost.
    const { result: items } = await request("/items");
    if (!includesEmail(items)) throw error;
  }
}

module.exports = { allowDriverLogin, driverLoginListConfig };
