import ReactDOM from "react-dom/client";
import App from "./App";

// Everything lives inside the single summoned overlay window now.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
