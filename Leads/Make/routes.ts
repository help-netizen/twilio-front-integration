import { createBrowserRouter } from "react-router";
import { Root } from "./components/Root";
import { CallsPage } from "./components/pages/CallsPage";
import { LeadsPage } from "./components/pages/LeadsPage";
import { NotFound } from "./components/pages/NotFound";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, Component: CallsPage },
      { path: "calls", Component: CallsPage },
      { path: "leads", Component: LeadsPage },
      { path: "*", Component: NotFound },
    ],
  },
]);
