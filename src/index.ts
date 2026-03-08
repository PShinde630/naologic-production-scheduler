import { ReflowService } from "./reflow/reflow.service";
import { scenarios } from "./sample-data/scenarios";

function printScenarioHeader(name: string, description: string): void {
  console.log("\n====================================================");
  console.log(`Scenario: ${name}`);
  console.log(description);
  console.log("====================================================");
}

function printOrders(label: string, orders: Array<{ docId: string; data: { startDate: string; endDate: string } }>): void {
  console.log(`\n${label}`);
  for (const order of orders) {
    console.log(`- ${order.docId}: ${order.data.startDate} -> ${order.data.endDate}`);
  }
}

function run(): void {
  const reflowService = new ReflowService();

  for (const scenario of scenarios) {
    printScenarioHeader(scenario.name, scenario.description);

    printOrders("Original Schedule", scenario.input.workOrders);

    const result = reflowService.reflow(scenario.input);

    printOrders("Updated Schedule", result.updatedWorkOrders);

    console.log("\nChanges");
    if (result.changes.length === 0) {
      console.log("- No changes");
    } else {
      for (const change of result.changes) {
        console.log(
          `- ${change.workOrderId}: start ${change.oldStartDate} -> ${change.newStartDate}, end ${change.oldEndDate} -> ${change.newEndDate}`
        );
      }
    }

    console.log("\nExplanation");
    for (const line of result.explanation) {
      console.log(line);
    }
  }
}

run();
