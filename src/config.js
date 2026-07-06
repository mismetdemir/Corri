import fs from "fs";

const CONFIG_FILE = "./config.json";

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }

  const data = fs.readFileSync(CONFIG_FILE, "utf8");

  if (!data.trim()) {
    return {};
  }

  return JSON.parse(data);
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
