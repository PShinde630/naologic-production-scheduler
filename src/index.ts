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

    try {
      const result = reflowService.reflow(scenario.input);

      if (scenario.expectedErrorContains) {
        console.log("\nResult");
        console.log(
          `- FAIL: Expected an error containing "${scenario.expectedErrorContains}" but scheduling succeeded.`
        );
        continue;
      }

      printOrders("Updated Schedule", result.updatedWorkOrders);

      console.log("\nChanges");
      if (result.changes.length === 0) {
        console.log("- No changes");
      } else {
        for (const change of result.changes) {
          console.log(`- ${change.workOrderId}`);
          console.log(`  start: ${change.oldStartDate} -> ${change.newStartDate}`);
          console.log(`  end:   ${change.oldEndDate} -> ${change.newEndDate}`);
          console.log("  why:");
          for (const reason of change.reasons) {
            console.log(`    - ${reason}`);
          }
        }
      }

      console.log("\nExplanation");
      for (const line of result.explanation) {
        console.log(line);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (scenario.expectedErrorContains) {
        const matched = message.includes(scenario.expectedErrorContains);
        console.log("\nResult");
        console.log(
          matched
            ? `- PASS: Caught expected error cause -> ${message}`
            : `- FAIL: Error did not match expected cause.\n  expected: ${scenario.expectedErrorContains}\n  actual:   ${message}`
        );
      } else {
        throw error;
      }
    }
  }
}

run();
