-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'finance', 'procurement', 'user');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'user';
