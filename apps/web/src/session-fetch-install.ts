// Installed before any other module runs, so every API request already uses the cookie session (audit L6 stage 2).
import { installSessionFetch } from "./session-fetch";

installSessionFetch();
