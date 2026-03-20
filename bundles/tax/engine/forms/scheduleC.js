/**
 * Schedule C — Profit or Loss From Business (Sole Proprietorship)
 */

export function mapScheduleC(result, taxReturn) {
  if (!taxReturn.selfEmployment) return {};

  const se = taxReturn.selfEmployment;
  const exp = se.expenses;
  const totalExpenses = Object.values(exp).reduce((sum, v) => sum + v, 0);
  const grossProfit = se.grossReceipts - se.costOfGoodsSold;

  const lines = {};

  lines["C"] = se.businessName || "";
  lines["D"] = se.businessCode || "";
  lines["E"] = se.ein || "";

  lines["1"] = se.grossReceipts;                   // Gross receipts
  lines["2"] = 0;                                  // Returns and allowances
  lines["3"] = se.grossReceipts;                   // Line 1 - line 2
  lines["4"] = se.costOfGoodsSold;                 // Cost of goods sold
  lines["5"] = grossProfit;                        // Gross profit
  lines["6"] = 0;                                  // Other income
  lines["7"] = grossProfit;                        // Gross income

  // Expenses
  lines["8"] = exp.advertising;
  lines["9"] = exp.carAndTruck;
  lines["10"] = exp.commissions;
  lines["15"] = exp.insurance;
  lines["17"] = exp.legalAndProfessional;
  lines["18"] = exp.officeExpense;
  lines["20b"] = exp.rentOrLease;
  lines["22"] = exp.supplies;
  lines["25"] = exp.utilities;
  lines["27a"] = exp.other;
  lines["27b"] = totalExpenses;                    // Total expenses before home office
  lines["28"] = totalExpenses;

  lines["29"] = grossProfit - totalExpenses;       // Tentative profit
  lines["30"] = se.homeOfficeDeduction;            // Home office deduction
  lines["31"] = result.income.schedCNetProfit;     // Net profit or loss

  return lines;
}
