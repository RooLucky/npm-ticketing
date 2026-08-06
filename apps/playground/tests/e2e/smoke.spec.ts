import { expect, test } from "@playwright/test";

test("creates a ticket with an attachment, downloads it, and replies", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Support tickets" })).toBeVisible();

  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "Question" }).click();
  await expect(page.getByText("No tickets found")).toBeVisible();
  await page.getByRole("combobox", { name: "Category" }).click();
  await page.getByRole("option", { name: "All categories" }).click();

  await page.getByRole("button", { name: "New ticket" }).click();
  await page.getByLabel("Subject").fill("Playwright attachment flow");
  await page
    .getByLabel("Description")
    .fill("Created by the private playground against the in-memory mock API.");

  await page.locator('input[type="file"]').setInputFiles({
    name: "unsafe.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("unsupported"),
  });
  await expect(page.getByText("unsafe.txt has an unsupported file type.")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "remove-me.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("temporary"),
  });
  await page.getByRole("button", { name: "Remove remove-me.pdf" }).click();
  await expect(page.getByText("remove-me.pdf")).not.toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "evidence.png",
    mimeType: "image/png",
    buffer: Buffer.from("ticketing-e2e-upload"),
  });
  await expect(page.getByText("evidence.png")).toBeVisible();
  await expect(page.locator('ul[aria-label="Selected attachments"] img')).toBeVisible();

  await page.route("**/mock/uploads/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ status: 500, body: "simulated upload failure" });
  });

  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.getByRole("progressbar", { name: "Uploading evidence.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.unroute("**/mock/uploads/**");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.getByText("Playwright attachment flow", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Ticket created successfully.");

  const attachment = page.getByRole("link", { name: "evidence.png" });
  await expect(attachment).toBeVisible();
  const downloadUrl = await attachment.getAttribute("href");
  expect(downloadUrl).toBeTruthy();
  const download = await page.request.get(downloadUrl!);
  expect(download.ok()).toBeTruthy();
  expect(await download.body()).toEqual(Buffer.from("ticketing-e2e-upload"));

  await page.getByLabel("Add a reply").fill("The ticket reply path works too.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("The ticket reply path works too.")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Reply sent successfully.");

  await page.getByRole("button", { name: "Back to tickets" }).click();
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "Playwright attachment flow" })
      .first()
      .getByText("1 reply"),
  ).toBeVisible();
});
