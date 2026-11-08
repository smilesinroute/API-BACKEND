"use strict";

const listName = "Smiles In Route Driver Login";
const listIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function driverLoginListConfig() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const listId = process.env.CLOUDFLARE_DRIVER_EMAIL_LIST_ID?.trim();
  const token = process.env.CLOUDFLARE_DRIVER_LIST_TOKEN?.trim();
  if (!/^[a-f0-9]{32}$/i.test(account ?? "") ||
      (listId && !listIdPattern.test(listId)) ||
      !token) return null;

  return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/gateway/lists`, listId, token };
}

async function allowDriverLogin({ url, listId, token }, email) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(6500);
  async function request(suffix, options) {
    const response = await fetch(url + suffix, { headers, signal, redirect: "error", ...options });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error("Cloudflare list request failed");
    return data;
  }

  const isDriverList = (item) => item?.type === "EMAIL" && item.name === listName;
  let list;
  if (listId) {
    ({ result: list } = await request(`/${listId}`));
    if (!isDriverList(list)) throw new Error("Wrong Cloudflare list");
  } else {
    const { result: lists } = await request("");
    const matches = lists.filter(isDriverList);
    if (matches.length !== 1 || !listIdPattern.test(matches[0].id ?? "")) {
      throw new Error("Expected one matching Cloudflare driver email list");
    }
    [list] = matches;
    listId = list.id;
  }

  const listPath = `/${listId}`;
  const includesEmail = (items) => items?.some((item) => item.value?.toLowerCase() === email);
  if (includesEmail(list.items)) return;
  try {
    await request(listPath, { method: "PATCH", body: JSON.stringify({ append: [{ value: email }] }) });
  } catch (error) {
    // The first attempt may have succeeded even if its response was lost.
    const { result: items } = await request(listPath + "/items");
    if (!includesEmail(items)) throw error;
  }
}

module.exports = { allowDriverLogin, driverLoginListConfig };
