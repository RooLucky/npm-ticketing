import { Ticketing } from "@/components/ticketing";

export default async function HomePage() {
  return (
    <main className="px-4 py-12">
      <Ticketing
        user={{
          id: "playwright-user",
          name: "Quanby Playground User",
          email: "playground@example.test",
        }}
        sourceSystem="ticketing-playground"
        moduleName="end-to-end-tests"
        pageUrl="/"
      />
    </main>
  );
}
