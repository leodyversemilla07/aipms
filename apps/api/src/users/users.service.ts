import { Injectable } from '@nestjs/common'
import { db } from '@workspace/db'

@Injectable()
export class UsersService {
  list() {
    return db.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
      },
    })
  }
}
