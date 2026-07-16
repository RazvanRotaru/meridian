import axios from "axios";

const first = axios.create({ baseURL: "https://one.example/v1" });
const firstAlias = first;
const second = axios.create({ baseURL: "https://two.example/v1" });

export async function loadFromFirstClient(): Promise<unknown> {
  return first.get("/users");
}

export async function loadFromFirstClientAlias(): Promise<unknown> {
  return firstAlias.get("/users");
}

export async function loadFromSecondClient(): Promise<unknown> {
  return second.get("/users");
}

export async function loadDirectFromFirstOrigin(): Promise<unknown> {
  return axios.get("https://one.example/users");
}

export async function loadDirectFromSecondOrigin(): Promise<unknown> {
  return axios.get("https://two.example/users");
}
