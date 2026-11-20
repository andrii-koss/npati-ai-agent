const { Server } = require("node:net");
const listen = Server.prototype.listen;
const port = Number(process.env.PORT);
const path = process.env.NPATI_APP_SOCKET;

// Keep each application's serving socket private to its Unix identity.
Server.prototype.listen = function (address, ...args) {
  const requestedPort = typeof address === "object" && address ? address.port : address;
  if (Number(requestedPort) !== port || !path) return listen.call(this, address, ...args);
  const callback = args.find(value => typeof value === "function");
  return listen.call(this, { path }, ...(callback ? [callback] : []));
};
