import { forwardFamilySearch } from "../../../../../../lib/search-proxy.js";
export const dynamic = "force-dynamic";
export function GET(
  request: Request,
  context: { params: Promise<{ familyId: string }> },
) {
  return forwardFamilySearch(request, context, "memories");
}
