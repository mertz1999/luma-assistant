import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { App } from "./App";
import { DesktopShell } from "./components/DesktopShell";

const client = new QueryClient();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <DesktopShell><App /></DesktopShell>
    </QueryClientProvider>
  </React.StrictMode>,
);
