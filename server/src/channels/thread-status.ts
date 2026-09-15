import type { ConversationStore } from "../conversations/store";
import {
  ConversationAccessError,
  ConversationNotFoundError,
  type ConversationLocalReadiness,
} from "../conversations/types";

export type LocalThreadAvailability = {
  status: "local" | "import_pending" | "external_unavailable" | "notfound";
  localReadiness?: ConversationLocalReadiness;
};

/** No accessible local row is not evidence that an old external conversation was deleted. */
export async function localThreadStatus(
  store: ConversationStore,
  threadId: string,
  userId: string,
): Promise<LocalThreadAvailability> {
  try {
    const { thread } = await store.readSnapshot({ id: userId }, threadId);
    return {
      status:
        thread.localReadiness === "not_ready" ? "import_pending" : "local",
      localReadiness: thread.localReadiness,
    };
  } catch (error) {
    if (
      error instanceof ConversationAccessError ||
      error instanceof ConversationNotFoundError
    ) {
      // The same answer for missing and foreign records avoids exposing another person's IDs.
      return { status: "external_unavailable" };
    }
    throw error;
  }
}
