import { checkProductionDeployment } from "../deployment.js";

const receipt = await checkProductionDeployment();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
