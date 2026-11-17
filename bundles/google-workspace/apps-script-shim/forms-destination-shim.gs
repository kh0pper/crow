/**
 * forms-destination-shim — Apps Script shim for the MCP `forms_set_destination` tool.
 *
 * WHY THIS EXISTS: the REST Google Forms API cannot set a form's response
 * destination (linking a form to a spreadsheet is UI-only there; the API can
 * only READ `linkedSheetId`). Apps Script's FormApp CAN do it, so the MCP tool
 * calls this one function via the Apps Script API's scripts.run.
 *
 * ONE-TIME DEPLOYMENT (all four steps required):
 *   1. script.new -> paste this file into a new STANDALONE Apps Script project
 *      (name it e.g. "forms-destination-shim").
 *   2. Project Settings -> "Google Cloud Platform (GCP) Project" -> change it to
 *      the SAME GCP project (by project number) as the OAuth client the MCP
 *      server authenticates with. scripts.run only accepts calls from tokens
 *      minted by an OAuth client in the script's own GCP project.
 *   3. Deploy -> New deployment -> type "API Executable" -> access "Only myself"
 *      (or your domain). Note the SCRIPT ID (not the deployment id).
 *   4. The calling token must carry every scope this script uses (see the
 *      oauthScopes note below): add "https://www.googleapis.com/auth/forms" to
 *      the MCP server's auth.SCOPES and re-authenticate once.
 *   Then set GWS_FORMS_SHIM_SCRIPT_ID=<Script ID> in the MCP server's environment.
 *
 * MANIFEST (appsscript.json) — declare explicit scopes so the caller's token
 * needs no more than these:
 *   {
 *     "timeZone": "Etc/UTC",
 *     "exceptionLogging": "STACKDRIVER",
 *     "runtimeVersion": "V8",
 *     "oauthScopes": [
 *       "https://www.googleapis.com/auth/forms",
 *       "https://www.googleapis.com/auth/spreadsheets"
 *     ]
 *   }
 */

/**
 * Link a form's responses into a spreadsheet (same effect as the Forms UI's
 * Responses -> "Link to Sheets"). Idempotent: re-linking to the same
 * spreadsheet is a no-op; linking to a different one moves the destination.
 *
 * @param {string} formId        the target form's ID
 * @param {string} spreadsheetId the destination spreadsheet's ID
 * @return {Object} { formId, spreadsheetId, destinationId } on success
 */
function setFormDestination(formId, spreadsheetId) {
  var form = FormApp.openById(formId);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, spreadsheetId);
  return {
    formId: formId,
    spreadsheetId: spreadsheetId,
    destinationId: form.getDestinationId(),
  };
}

/**
 * Unlink a form from its response spreadsheet (Responses -> Unlink). The
 * existing response tab stays in the spreadsheet; the form keeps its responses.
 *
 * @param {string} formId the target form's ID
 * @return {Object} { formId, unlinked: true }
 */
function removeFormDestination(formId) {
  FormApp.openById(formId).removeDestination();
  return { formId: formId, unlinked: true };
}
