// Browser fixtures own all requests and await their assertions before shutdown.
export async function closeBrowserServer(app) {
  const closing = app.close();
  app.server.closeAllConnections();
  await closing;
}
