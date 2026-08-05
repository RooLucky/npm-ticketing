import { Ticketing } from "@/components/ticketing";

export default async function HomePage() {
  return (
    <main className="px-4 py-12">
      <Ticketing
        user={{ id: "next15-fixture", name: "Next.js 15 Fixture" }}
        sourceSystem="next15-tailwind3-fixture"
        pageUrl="/"
      />
    </main>
  );
}
