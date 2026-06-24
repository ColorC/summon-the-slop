import "./logboot"; // 全套日志: 必须最早 import, 抢在任何报错之前装好 console/error 钩子
import ReactDOM from "react-dom/client";
import App from "./App";

// Everything lives inside the single summoned overlay window now.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
