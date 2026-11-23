export default function ({ on, log }: any) {
  on("request", (msg: any) => { log("request", msg.req?.method, msg.req?.url); return { action: "pass" }; });
  on("response", (msg: any) => { log("response", msg.res?.status); return { action: "pass" }; });
}
